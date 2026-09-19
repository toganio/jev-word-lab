import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Jev Word Lab',
  description:
    'Explore category, group, and word selection with TypeSafe Jev and an English dictionary.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
