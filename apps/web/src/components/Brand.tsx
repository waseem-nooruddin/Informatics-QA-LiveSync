import { Link } from 'react-router-dom';

// The official Informatics logo (src/assets/brand/informatics-logo.*) is picked up automatically
// (SRS V1.5 §3). The supplied artwork is a white wordmark on navy, so it is only placed on navy
// surfaces (homepage hero, header, sidebar, mobile top bar). Without the file, a clearly labelled
// pending placeholder is shown — never a recreated logo.
const found = import.meta.glob('../assets/brand/informatics-logo.{svg,png,webp}', { eager: true, import: 'default' }) as Record<string, string>;
export const LOGO_URL: string | null = Object.values(found)[0] ?? null;

export const PRODUCT_NAME = 'Informatics QA LiveSync';

// Heights stay at or below the artwork's native 63 px so the wordmark never upscales and blurs.
const HEIGHT = { sm: 'h-7', md: 'h-9', hero: 'h-12 sm:h-14' } as const;

export function Logo({ size, onDark = false }: { size: 'sm' | 'md' | 'hero'; onDark?: boolean }) {
  if (LOGO_URL) return <img src={LOGO_URL} alt="Informatics — Empowering progress since 1983" className={`${HEIGHT[size]} w-auto max-w-full self-start object-contain`} />;
  return (
    <span
      role="img"
      aria-label="Official Informatics logo (pending upload)"
      className={`${HEIGHT[size]} inline-flex min-w-10 items-center justify-center rounded-lg border-[1.5px] border-dashed px-2 text-center text-[9px] leading-tight font-bold tracking-wide uppercase ${
        onDark ? 'border-sky text-sky-soft' : 'border-line-strong text-ink-3'
      } ${size === 'hero' ? 'w-64 text-[12px]' : ''}`}
    >
      {size === 'hero' ? 'Official Informatics logo · pending upload' : 'Logo'}
    </span>
  );
}

export function BrandLink() {
  return (
    <Link to="/" className="flex flex-col items-start gap-1 rounded-lg px-1 py-1" aria-label={`${PRODUCT_NAME} home`}>
      {LOGO_URL ? (
        <>
          <Logo size="sm" onDark />
          <span className="pl-0.5 text-[0.74rem] font-semibold tracking-wide text-sky">QA LiveSync</span>
        </>
      ) : (
        <span className="flex items-center gap-2.5">
          <Logo size="sm" onDark />
          <span className="flex flex-col leading-tight">
            <span className="text-[0.92rem] font-bold tracking-tight text-navy-ink">Informatics</span>
            <span className="text-[0.74rem] font-medium text-sky">QA LiveSync</span>
          </span>
        </span>
      )}
    </Link>
  );
}
