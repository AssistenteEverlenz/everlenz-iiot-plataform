// Printing a dashboard to paper or PDF.
//
// Charts are drawn by measuring their container on screen and do not redraw when the browser
// switches to its print layout, so a chart sized for a wide monitor spilled over its
// neighbours or was cut on paper. Before printing, the page is laid out at the printable
// width of an A4 landscape sheet; the charts see their containers resize and redraw at that
// width; then the print dialog opens, and the screen layout comes back afterwards.

const PRINT_CLASS = 'print-layout';
const REDRAW_MS = 700;

export async function printDashboard() {
  const body = document.body;
  body.classList.add(PRINT_CLASS);
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, REDRAW_MS));
  const restore = () => {
    body.classList.remove(PRINT_CLASS);
    window.dispatchEvent(new Event('resize'));
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
