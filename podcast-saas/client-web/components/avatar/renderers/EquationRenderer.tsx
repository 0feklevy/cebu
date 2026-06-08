'use client';

import { useEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function EquationRenderer({ latex, scale = 1 }: { latex: string; scale?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(latex, ref.current, { displayMode: true, throwOnError: false, errorColor: '#f06292' });
    } catch {
      if (ref.current) ref.current.textContent = latex;
    }
  }, [latex]);

  return (
    <div
      className="avatar-equation-renderer"
      style={{ transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left', color: '#e8eef6' }}
      ref={ref}
    />
  );
}
