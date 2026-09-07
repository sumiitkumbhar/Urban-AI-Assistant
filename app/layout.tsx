import React from 'react'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="ui-compact">
      <body className={`${inter.className} antialiased`}>
        {children}
      </body>
    </html>
  )
}