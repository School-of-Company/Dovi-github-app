import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Kafka, KafkaMessage } from 'kafkajs';
import { BaseKafkaConsumer } from '../kafka/base-kafka.consumer';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { PoisonMessageError } from '../kafka/poison-message.error';
import { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import type {
  SandboxProbeCompletedPayload,
  SandboxProbeStatus,
} from './dto/sandbox-probe-completed.payload';

const VALID_STATUSES = new Set<SandboxProbeStatus>([
  'passed',
  'found_issue',
  'inconclusive',
]);

// 기존 review-result/comment-answer-result 컨슈머 그룹에 얹지 않고 완전히 독립된
// 그룹을 쓴다 — 샌드박스 프로브 트랙은 메인 리뷰/코멘트 답변과 무관하다.
const GROUP_ID = 'github-app-sandbox-probe-result';

@Injectable()
export class SandboxProbeResultConsumerService
  extends BaseKafkaConsumer
  implements OnModuleInit
{
  private readonly completedTopic =
    process.env.KAFKA_SANDBOX_PROBE_COMPLETED_TOPIC!;

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    private readonly responder: SandboxProbeResponderService,
  ) {
    super(kafka, GROUP_ID, [process.env.KAFKA_SANDBOX_PROBE_COMPLETED_TOPIC!]);
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  protected async handleMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<void> {
    if (!message.value) {
      this.logger.warn(`빈 메시지 수신, 스킵: topic=${topic}`);
      return;
    }

    if (topic !== this.completedTopic) {
      this.logger.warn(`알 수 없는 토픽 메시지 수신, 스킵: topic=${topic}`);
      return;
    }

    const payload = this.parse(message);
    this.validate(payload);

    await this.responder.handle(payload);
  }

  private parse(message: KafkaMessage): SandboxProbeCompletedPayload {
    try {
      return JSON.parse(
        message.value!.toString(),
      ) as SandboxProbeCompletedPayload;
    } catch (err) {
      throw new PoisonMessageError(
        `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // formatSandboxProbeComment는 evidence/findings가 정상 형태라는 전제로
  // .length 등을 바로 호출한다 — 필드 누락/타입 불일치를 여기서 미리 걸러내지
  // 않으면 TypeError(비-PoisonMessageError)가 던져져 오프셋이 커밋되지 않고
  // 파티션이 영구 정지한다.
  private validate(
    payload: SandboxProbeCompletedPayload,
  ): asserts payload is SandboxProbeCompletedPayload {
    if (!payload?.reviewJobId) {
      throw new PoisonMessageError(
        'Invalid sandbox probe completed payload: reviewJobId is missing',
      );
    }
    if (!VALID_STATUSES.has(payload.status)) {
      throw new PoisonMessageError(
        `Invalid sandbox probe completed payload: unknown status "${String(payload.status)}" (${payload.reviewJobId})`,
      );
    }
    if (typeof payload.evidence !== 'string') {
      throw new PoisonMessageError(
        `Invalid sandbox probe completed payload: evidence is not a string (${payload.reviewJobId})`,
      );
    }
    if (!Array.isArray(payload.findings)) {
      throw new PoisonMessageError(
        `Invalid sandbox probe completed payload: findings is not an array (${payload.reviewJobId})`,
      );
    }
    const malformedFinding = payload.findings.find(
      (finding) =>
        typeof finding?.title !== 'string' ||
        typeof finding.message !== 'string' ||
        typeof finding.evidence !== 'string',
    );
    if (malformedFinding) {
      throw new PoisonMessageError(
        `Invalid sandbox probe completed payload: malformed finding (${payload.reviewJobId})`,
      );
    }
  }
}
