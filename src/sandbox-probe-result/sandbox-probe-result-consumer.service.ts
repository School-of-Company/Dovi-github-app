import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Kafka, KafkaMessage } from 'kafkajs';
import { BaseKafkaConsumer } from '../kafka/base-kafka.consumer';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { PoisonMessageError } from '../kafka/poison-message.error';
import { SandboxProbeResponderService } from './sandbox-probe-responder.service';
import type { SandboxProbeCompletedPayload } from './dto/sandbox-probe-completed.payload';

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
    if (!payload?.reviewJobId) {
      throw new PoisonMessageError(
        'Invalid sandbox probe completed payload: reviewJobId is missing',
      );
    }

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
}
