// Minimal typings for page-flip 2.0.7 (ships JS only).
declare module 'page-flip' {
  export type PageFlipEvent = { data: unknown; object: PageFlip }
  export class PageFlip {
    constructor(element: HTMLElement, settings: Record<string, unknown>)
    loadFromImages(images: string[]): void
    on(
      event: 'init' | 'update' | 'flip' | 'changeState' | 'changeOrientation',
      callback: (e: PageFlipEvent) => void
    ): this
    flipNext(): void
    flipPrev(): void
    turnToPage(page: number): void
    getCurrentPageIndex(): number
    getPageCount(): number
    getState(): string
    destroy(): void
  }
}
