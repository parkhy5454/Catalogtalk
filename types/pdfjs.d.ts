// pdf.js 6 ships its types under types/src; map the browser build entry to them.
declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist/types/src/pdf';
}
