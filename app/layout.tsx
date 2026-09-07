import React from 'react'
import './globals.css'
import './workspace.css'

export const metadata = {
  title: 'Urban AI Assistant — Planning & Construction',
  description: 'Your intelligent assistant for urban planning & construction',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="urban-body antialiased">
        {children}
      </body>
    </html>
  )
}
