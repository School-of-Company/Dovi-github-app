// 컨슈머가 메시지를 역직렬화/검증할 수 없을 때 던지는 오류. 재시도해도 절대
// 성공할 수 없으므로(예: 깨진 JSON, 필수 필드 누락) BaseKafkaConsumer는 이
// 오류를 잡으면 로그만 남기고 오프셋을 커밋해 다음 메시지로 넘어간다.
// GitHub API 오류 등 일시적일 수 있는 오류는 이 타입으로 던지지 않아야
// 기존처럼 재시도(오프셋 미커밋) 대상이 된다.
export class PoisonMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoisonMessageError';
  }
}
