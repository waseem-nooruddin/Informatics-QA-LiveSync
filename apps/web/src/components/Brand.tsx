import { Link } from 'react-router-dom';

// Owner decision 2026-10-24 (docs/approvals/ui-v1.1.md): no company name and no logos anywhere
// in the product — a plain text product name only.
export const PRODUCT_NAME = 'QA LiveSync';

export function BrandLink() {
  return (
    <Link to="/" className="rounded-lg px-1 py-1 text-[1rem] font-bold tracking-tight text-navy-ink" aria-label={`${PRODUCT_NAME} home`}>
      QA <span className="text-sky">LiveSync</span>
    </Link>
  );
}
