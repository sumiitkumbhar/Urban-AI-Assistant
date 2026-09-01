// app/api/rag/ingest/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { ingestMultiplePdfs } from '@/lib/chromaIngest'
import type { Region } from '@/app/api/rag/corpus'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()

    const regionRaw = form.get('region')
    const region = (regionRaw || undefined) as Region | undefined

    const fileEntries = form.getAll('files') as File[]
    if (!fileEntries.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    const files = await Promise.all(
      fileEntries.map(async (file) => {
        const arrayBuf = await file.arrayBuffer()
        return {
          name: file.name,
          buffer: Buffer.from(arrayBuf),
        }
      }),
    )

    // Optional: enforce batch of max 3 PDFs
    if (files.length > 3) {
      return NextResponse.json(
        { error: 'Maximum 3 PDFs per request' },
        { status: 400 },
      )
    }

    await ingestMultiplePdfs(files, { region })

    return NextResponse.json({ ok: true, ingested: files.length })
  } catch (err: any) {
    console.error('Ingest error:', err)
    return NextResponse.json(
      { error: err?.message || 'Failed to ingest PDFs' },
      { status: 500 },
    )
  }
}
