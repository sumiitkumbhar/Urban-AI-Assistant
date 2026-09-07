import React from 'react'
import { Manrope } from 'next/font/google'
import './globals.css'

// Inter is the reflexive default for AI-built interfaces and reads as such.
// Manrope keeps the neutrality a regulatory tool needs but has actual
// character in the terminals and a wider, steadier lower-case - it holds up
// at display size where Inter goes generic. Variable weight so headings and
// UI chrome share one file.
const sans = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
})

const APP_NAME = 'Urban AI Assistant'
const APP_DESCRIPTION =
  'Document-grounded AI assistant for planning and building-regulation questions - hybrid search, AI reranking, and citation-backed, groundedness-checked answers.'

export const metadata = {
  title: {
    default: `${APP_NAME} - Grounded Planning & Building Regs Q&A`,
    template: `%s - ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  openGraph: {
    title: APP_NAME,
    description: APP_DESCRIPTION,
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: APP_NAME,
    description: APP_DESCRIPTION,
  },
}

// Matches --paper. Without this the mobile browser chrome sits as a hard
// white band above a warm ground, which is the first thing that makes a
// web app feel unfinished on a phone.
export const viewport = {
  themeColor: '#f7f4ee',
  colorScheme: 'light',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`ui-compact ${sans.variable}`}>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}