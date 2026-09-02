import { CommentAnswerDispatcherService } from './comment-answer-dispatcher.service';
import type { IdempotencyStore } from '../redis/idempotency.store';
import type { JobStateStore } from '../redis/job-state.store';
import type { CommentAnswerContextStore } from '../redis/comment-answer-context.store';
import type { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { CommentAnswerRequestPayload } from './dto/comment-answer-request.payload';
import type { CommentAnswerContext } from '../redis/comment-answer-context.type';

describe('CommentAnswerDispatcherService', () => {
  const payload: CommentAnswerRequestPayload = {
    commentJobId: 'qa:1:1:999',
    repositoryId: 1,
    prNumber: 1,
    path: 'src/foo.ts',
    line: 12,
    diffHunk: '@@ -1 +1 @@',
    thread: [],
  };

  const context: CommentAnswerContext = {
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    installationId: 123,
    rootCommentId: 100,
  };

  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let jobStateStore: { get: jest.Mock; set: jest.Mock };
  let commentAnswerContextStore: { set: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: CommentAnswerDispatcherService;

  beforeEach(() => {
    process.env.KAFKA_COMMENT_ANSWER_REQUEST_TOPIC =
      'pr.comment.answer.requested';

    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    jobStateStore = { get: jest.fn(), set: jest.fn() };
    commentAnswerContextStore = { set: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new CommentAnswerDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      jobStateStore as unknown as JobStateStore,
      commentAnswerContextStore as unknown as CommentAnswerContextStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });

  it('idempotency에 이미 존재하면 발행하지 않고 스킵한다', async () => {
    idempotencyStore.exists.mockResolvedValue(true);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).not.toHaveBeenCalled();
    expect(commentAnswerContextStore.set).not.toHaveBeenCalled();
    expect(kafkaProducer.send).not.toHaveBeenCalled();
  });

  it.each(['completed', 'processing'] as const)(
    'jobState가 %s면 발행하지 않고 스킵한다',
    async (state) => {
      idempotencyStore.exists.mockResolvedValue(false);
      jobStateStore.get.mockResolvedValue(state);

      await service.dispatch(payload, context);

      expect(jobStateStore.set).not.toHaveBeenCalled();
      expect(commentAnswerContextStore.set).not.toHaveBeenCalled();
      expect(kafkaProducer.send).not.toHaveBeenCalled();
    },
  );

  it('중복이 아니면 requested 상태와 job context를 저장한 후 발행한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);

    await service.dispatch(payload, context);

    expect(jobStateStore.set).toHaveBeenCalledWith(
      payload.commentJobId,
      'requested',
    );
    expect(commentAnswerContextStore.set).toHaveBeenCalledWith(
      payload.commentJobId,
      context,
    );
    expect(kafkaProducer.send).toHaveBeenCalledWith(
      'pr.comment.answer.requested',
      payload,
      payload.commentJobId,
    );
  });

  it('Kafka 발행이 실패하면 에러를 throw한다', async () => {
    idempotencyStore.exists.mockResolvedValue(false);
    jobStateStore.get.mockResolvedValue(null);
    kafkaProducer.send.mockRejectedValue(new Error('kafka down'));

    await expect(service.dispatch(payload, context)).rejects.toThrow(
      'kafka down',
    );
  });
});
