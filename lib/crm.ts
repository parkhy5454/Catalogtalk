// Shared labels for the customer pipeline.
export const STAGES = [
  { key: 'contact', label: '문의' },
  { key: 'qualified', label: '검토' },
  { key: 'quote', label: '견적' },
  { key: 'negotiation', label: '협상' },
  { key: 'won', label: '성사' },
  { key: 'lost', label: '보류' },
] as const

export type StageKey = (typeof STAGES)[number]['key']

export const stageLabel = (k: string) => STAGES.find((s) => s.key === k)?.label ?? k

export const TIMELINE_LABEL: Record<string, string> = {
  lead: '문의',
  visit: '열람',
  quote: '견적',
  order: '주문',
  send: '발송',
  note: '메모',
  reorder_due: '재구매',
}
