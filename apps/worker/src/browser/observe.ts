import type { Page } from 'playwright';

const MAX_ELEMENTS = 150;
const MAX_TEXT = 6000;

export const refSelector = (ref: number): string => `[data-vc-ref="${ref}"]`;

/**
 * Tags visible interactive elements with data-vc-ref and returns a compact text view of the
 * page for the model. Public Playwright API only; refs are valid until the next observation.
 */
export async function observe(page: Page): Promise<string> {
  const snapshot = await page.evaluate(
    ({ maxElements, maxText }) => {
      document.querySelectorAll('[data-vc-ref]').forEach((el) => el.removeAttribute('data-vc-ref'));
      const selector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=true], [onclick]';
      const lines: string[] = [];
      let ref = 0;
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (ref >= maxElements) break;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
        if ((el as HTMLInputElement).type === 'hidden') continue;
        el.setAttribute('data-vc-ref', String(++ref));
        const input = el as HTMLInputElement;
        const tag = el.tagName.toLowerCase();
        const attrs = [
          input.type && tag === 'input' ? `type=${input.type}` : '',
          input.name ? `name=${input.name}` : '',
          input.placeholder ? `placeholder="${input.placeholder}"` : '',
          el.getAttribute('aria-label') ? `aria-label="${el.getAttribute('aria-label')}"` : '',
          tag === 'a' ? `href=${(el as HTMLAnchorElement).getAttribute('href')}` : '',
          // Never echo secrets back to the model.
          'value' in input && input.value && input.type !== 'password' ? `value="${String(input.value).slice(0, 60)}"` : '',
        ].filter(Boolean);
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        lines.push(`[${ref}] <${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}> ${text}`.trim());
      }
      return { title: document.title, elements: lines, text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, maxText) };
    },
    { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
  );
  return [
    `URL: ${page.url()}`,
    `Title: ${snapshot.title}`,
    `Interactive elements (use the [ref] number):`,
    snapshot.elements.join('\n') || '(none)',
    `Visible text:`,
    snapshot.text || '(empty)',
  ].join('\n');
}
