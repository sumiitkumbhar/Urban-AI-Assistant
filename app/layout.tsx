import React from 'react'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'Urban Co-pilot - AI-Powered Construction Management',
  description: 'Your intelligent assistant for urban planning & construction',
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