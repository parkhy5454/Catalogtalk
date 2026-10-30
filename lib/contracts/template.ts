// Standard terms for a trade made from an accepted quote. DRAFT: needs legal review before use.
export const DEFAULT_TERMS = `제1조 (목적)
본 문서는 아래 당사자 간 상품 거래에 관한 기본 조건을 정합니다.

제2조 (거래 내용)
거래 금액은 아래 표시 금액이며, 세금 처리는 당사자가 따로 정합니다. 상품의 세부 내용은 발행자가 보낸 견적과 카탈로그에 따릅니다.

제3조 (결제)
결제 방법과 시기는 당사자가 따로 합의합니다.

제4조 (납품과 검수)
납품 일정과 검수 방법은 당사자가 합의합니다.

제5조 (취소와 환불)
취소와 환불은 관계 법령과 당사자 합의에 따릅니다.

제6조 (분쟁 해결)
분쟁이 생기면 당사자가 먼저 협의해 해결합니다.`

export function buildContractBody(opts: {
  sellerName: string
  buyerName: string
  buyerCompany: string | null
  amount: number
  terms: string
}): string {
  const buyer = opts.buyerCompany ? `${opts.buyerCompany} ${opts.buyerName}` : opts.buyerName
  return [
    `판매자: ${opts.sellerName}`,
    `구매자: ${buyer}`,
    `거래 금액: ${opts.amount.toLocaleString('ko-KR')}원`,
    '',
    opts.terms.trim(),
    '',
    '이 문서는 카탈로그톡에서 만든 기록용 동의 문서예요. 구매자가 "동의"를 누르면 확인 시각이 함께 기록돼요.',
  ].join('\n')
}
