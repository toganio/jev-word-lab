import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Jev Word Lab',
  description:
    'İngilizce sözlük üzerinde TypeSafe Jev ile kategori, grup ve kelime seçimini test et.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
