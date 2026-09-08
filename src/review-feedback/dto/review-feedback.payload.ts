export interface ReviewFeedbackPayload {
  reviewJobId: string;
  findingIndex: number;
  reflected: boolean;
  reason?: string;
}
