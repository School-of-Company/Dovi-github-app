import type { Kafka } from 'kafkajs';
import { SandboxProbeResultConsumerService } from './sandbox-probe-result-consumer.service';
import { PoisonMessageError } from '../kafka/poison-message.error';
import type { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import type { SandboxProbeCompletedPayload } from './dto/sandbox-probe-completed.payload';

interface ConsumerWithHandleMessage {
  handleMessage(topic: string, message: { value: Buffer }): Promise<void>;
}

describe('SandboxProbeResultConsumerService', () => {
  const completedTopic = 'pr.sandbox.probe.completed';

  let responder: { handle: jest.Mock };
  let service: SandboxProbeResultConsumerService;

  beforeEach(() => {
    process.env.KAFKA_SANDBOX_PROBE_COMPLETED_TOPIC = completedTopic;

    responder = { handle: jest.fn() };

    const fakeConsumer = {
      connect: jest.fn(),
      subscribe: jest.fn(),
      on: jest.fn(),
      run: jest.fn(),
      disconnect: jest.fn(),
      commitOffsets: jest.fn(),
      events: { CRASH: 'consumer.crash' },
    };
    const fakeKafka = { consumer: jest.fn().mockReturnValue(fakeConsumer) };

    service = new SandboxProbeResultConsumerService(
      fakeKafka as unknown as Kafka,
      responder as unknown as SandboxProbeResponderService,
    );
  });

  it('completed 토픽 메시지를 responder에 그대로 전달한다', async () => {
    const payload: SandboxProbeCompletedPayload = {
      reviewJobId: '1:5:sha',
      repositoryId: 1,
      prNumber: 5,
      headSha: 'sha',
      status: 'found_issue',
      evidence: 'boom',
      findings: [],
    };
    const message = { value: Buffer.from(JSON.stringify(payload)) };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      completedTopic,
      message,
    );

    expect(responder.handle).toHaveBeenCalledWith(payload);
  });

  it('reviewJobId가 없는 payload는 PoisonMessageError를 던진다', async () => {
    const message = { value: Buffer.from(JSON.stringify({ foo: 'bar' })) };

    await expect(
      (service as unknown as ConsumerWithHandleMessage).handleMessage(
        completedTopic,
        message,
      ),
    ).rejects.toBeInstanceOf(PoisonMessageError);
    expect(responder.handle).not.toHaveBeenCalled();
  });

  it('깨진 JSON은 PoisonMessageError를 던진다', async () => {
    const message = { value: Buffer.from('{not-json') };

    await expect(
      (service as unknown as ConsumerWithHandleMessage).handleMessage(
        completedTopic,
        message,
      ),
    ).rejects.toBeInstanceOf(PoisonMessageError);
    expect(responder.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['status가 유효하지 않으면', { status: 'unknown' }],
    ['evidence가 문자열이 아니면', { evidence: undefined }],
    ['findings가 배열이 아니면', { findings: undefined }],
    [
      'findings 항목이 깨져 있으면',
      { findings: [{ title: 't', message: 'm' }] },
    ],
  ])(
    '%s PoisonMessageError를 던지고 formatter까지 도달하지 않는다',
    async (_label, overrides) => {
      const payload = {
        reviewJobId: '1:5:sha',
        repositoryId: 1,
        prNumber: 5,
        headSha: 'sha',
        status: 'passed',
        evidence: '',
        findings: [],
        ...overrides,
      };
      const message = { value: Buffer.from(JSON.stringify(payload)) };

      await expect(
        (service as unknown as ConsumerWithHandleMessage).handleMessage(
          completedTopic,
          message,
        ),
      ).rejects.toBeInstanceOf(PoisonMessageError);
      expect(responder.handle).not.toHaveBeenCalled();
    },
  );

  it('알 수 없는 토픽은 responder를 호출하지 않고 스킵한다', async () => {
    const message = { value: Buffer.from('{}') };

    await (service as unknown as ConsumerWithHandleMessage).handleMessage(
      'unknown.topic',
      message,
    );

    expect(responder.handle).not.toHaveBeenCalled();
  });
});
