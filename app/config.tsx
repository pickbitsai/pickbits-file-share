// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

type PublicConfig = { businessName: string; quotas: { perFileBytes: number; perMemberBytes: number }; demo: boolean; demoUsers?: { id: string; name: string }[]; demoDocumentUrl?: string };
const fallback: PublicConfig = { businessName: '', quotas: { perFileBytes: 1024 ** 3, perMemberBytes: 100 * 1024 ** 3 }, demo: false };
const Configuration = createContext(fallback);
export const useAppConfig = () => useContext(Configuration);
export const appTitle = (config: PublicConfig) => config.businessName ? `${config.businessName} files` : 'PickBits File Share';
export function AppConfiguration({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState(fallback);
  const banner = useRef<HTMLElement>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  useEffect(() => {
    if (!banner.current) return;
    const observer = new ResizeObserver(entries => setBannerHeight(entries[0].target.getBoundingClientRect().height));
    observer.observe(banner.current); return () => observer.disconnect();
  }, [config.demo]);
  useEffect(() => { let live = true; fetch('/api/config').then(response => { if (!response.ok) throw new Error('Configuration unavailable'); return response.json(); }).then(value => { if (live) { setConfig(value); document.title = appTitle(value); } }).catch(() => {}); return () => { live = false; }; }, []);
  return <Configuration.Provider value={config}><div className={config.demo ? 'demo-shell' : undefined} style={{ '--demo-banner-height': `${bannerHeight}px` } as CSSProperties}>
    {config.demo && <aside ref={banner} className="demo-banner" aria-label="Demo mode"><strong>DEMO MODE: local only, no real sign-in</strong><span>Synthetic Mesa Sprout Landscaping workspace.</span><nav aria-label="Demo users">{config.demoUsers?.map(user => <a key={user.id} href={`/api/auth/login?user=${encodeURIComponent(user.id)}`}>Use {user.name}</a>)}<a href={config.demoDocumentUrl} target="_blank" rel="noopener noreferrer">Open sample agreement</a></nav></aside>}
    {children}
    <footer className="output-stamp">Made with PickBits File Share</footer>
  </div></Configuration.Provider>;
}
