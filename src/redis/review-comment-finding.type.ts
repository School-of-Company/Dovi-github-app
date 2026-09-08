// 리뷰 코멘트 id → 원본 pr.review.completed 이벤트의 finding 위치.
// 이 코멘트 스레드에 반영 여부 답글이 달렸을 때 어느 reviewJobId/findingIndex에
// 대한 것인지 역매핑하는 데 쓴다.
export interface ReviewCommentFinding {
  reviewJobId: string;
  findingIndex: number;
}
