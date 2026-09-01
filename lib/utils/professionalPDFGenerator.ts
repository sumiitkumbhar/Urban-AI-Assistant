// professionalPDFGenerator.ts
// Dependencies: pdf-lib

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// ==================== TYPE DEFINITIONS ====================
type ThemeOption = {
  id: string
  name: string
  primaryColor: string
  accentColor: string
  gradient: string
}

type ReportConfig = {
  reportType: string
  period?: string
  location?: string
  projectName?: string
  language?: 'en' | 'hi' | 'regional'
  state?: string
  analysisType?: 'land' | 'contract'
}

export type GeneratedReportSection = {
  id: string
  title: string
  body: string
  category?: string
  importance?: 'high' | 'medium' | 'low'
  type?: 'summary' | 'risk' | 'market' | 'scenario' | 'compliance' | 'other'
}

type ModeContent = {
  mode: string
  pages: number
  duration: string
  sections: string[]
  features: string[]
  complianceChecks: any[]
  riskMetrics: any[]
  predictiveInsights: any[]
  scenarios: any[]
  taxCalculation?: any
}

// ==================== CONSTANTS & UTILS ====================

const FONT = {
  title: 20,
  subtitle: 14,
  heading: 13,
  subheading: 11,
  body: 10,
  caption: 9,
} as const

const A4 = {
  w: 595.28,
  h: 841.89,
} as const

function hexToRgb(hex: string) {
  const clean = (hex || '').replace('#', '')
  const full =
    clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean || '1e3a8a'
  const bigint = parseInt(full, 16)
  return rgb(
    ((bigint >> 16) & 255) / 255,
    ((bigint >> 8) & 255) / 255,
    (bigint & 255) / 255,
  )
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  if (!text) return []
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxCharsPerLine) {
      lines.push(current.trim())
      current = w
    } else {
      current = (current + ' ' + w).trim()
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}

// ==================== SHARED DRAW HELPERS ====================

function headerBar(
  page: any,
  font: any,
  bold: any,
  config: ReportConfig,
  primary: any,
  sectionTitle: string,
  subtitle?: string,
) {
  page.drawRectangle({
    x: 0,
    y: A4.h - 56,
    width: A4.w,
    height: 56,
    color: rgb(0.05, 0.07, 0.12),
  })

  page.drawRectangle({
    x: 0,
    y: A4.h - 12,
    width: A4.w,
    height: 12,
    color: primary,
  })

  page.drawText(sectionTitle.toUpperCase(), {
    x: 32,
    y: A4.h - 34,
    size: FONT.heading,
    font: bold,
    color: rgb(0.96, 0.98, 1),
  })

  if (subtitle) {
    page.drawText(subtitle, {
      x: 32,
      y: A4.h - 50,
      size: FONT.caption,
      font,
      color: rgb(0.78, 0.82, 0.95),
    })
  }

  const meta = `${config.reportType || 'Feasibility Analysis'} • ${
    config.period || '2024-05'
  }`
  page.drawText(meta, {
    x: 320,
    y: A4.h - 34,
    size: FONT.caption,
    font,
    color: rgb(0.76, 0.82, 0.96),
  })
}

function footerBar(page: any, font: any, idx: number, total: number) {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: A4.w,
    height: 36,
    color: rgb(0.06, 0.08, 0.14),
  })

  page.drawText('Prepared by Urban Co-pilot - AI-Powered Analysis', {
    x: 32,
    y: 12,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.95),
  })

  page.drawText(`Page ${idx + 1} of ${total}`, {
    x: A4.w - 120,
    y: 12,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.95),
  })
}

// Basic cover page
function coverPage(
  pdf: PDFDocument,
  font: any,
  bold: any,
  primary: any,
  config: ReportConfig,
  modeContent: ModeContent,
) {
  const p = pdf.addPage([A4.w, A4.h])

  p.drawRectangle({
    x: 0,
    y: 0,
    width: A4.w,
    height: A4.h,
    color: rgb(0.06, 0.08, 0.14),
  })

  p.drawRectangle({
    x: 0,
    y: A4.h - 220,
    width: A4.w,
    height: 220,
    color: primary,
    opacity: 0.18,
  })

  const title = config.projectName || 'Professional Analysis'
  p.drawText(title, {
    x: 40,
    y: A4.h - 180,
    size: 16,
    font: bold,
    color: rgb(0.96, 0.98, 1),
  })

  p.drawText('REPORT', {
    x: 40,
    y: A4.h - 210,
    size: 28,
    font: bold,
    color: rgb(0.99, 1, 1),
  })

  const subtitle = `${config.reportType || 'Land Feasibility Analysis'} • ${
    config.state || 'Maharashtra'
  } • ${config.period || '2024-05'}`
  p.drawText(subtitle, {
    x: 40,
    y: A4.h - 240,
    size: 12,
    font,
    color: rgb(0.88, 0.92, 1),
  })

  const loc = config.location || 'Panvel, Maharashtra'
  const modeLine = `${modeContent.mode || 'Extended'} • ${
    modeContent.pages || 40
  } pages • ${modeContent.duration || '15 minutes'}`
  p.drawText(loc, {
    x: 40,
    y: A4.h - 270,
    size: 11,
    font,
    color: rgb(0.9, 0.94, 1),
  })
  p.drawText(modeLine, {
    x: 40,
    y: A4.h - 288,
    size: 10,
    font,
    color: rgb(0.8, 0.86, 1),
  })
}

// Simple generic section page helper
function sectionPage(
  pdf: PDFDocument,
  font: any,
  bold: any,
  title: string,
  body: string,
  bullets: string[],
  primary: any,
  accent: any,
) {
  const page = pdf.addPage([A4.w, A4.h])
  headerBar(page, font, bold, { reportType: title } as any, primary, title)

  const marginX = 40
  let y = A4.h - 96

  page.drawRectangle({
    x: marginX,
    y: y - 80,
    width: A4.w - marginX * 2,
    height: 80,
    color: rgb(0.07, 0.11, 0.2),
    opacity: 0.96,
  })

  page.drawText(title, {
    x: marginX + 16,
    y: y - 24,
    size: 11,
    font: bold,
    color: rgb(0.96, 0.98, 1),
  })

  const lines = wrapText(body, 110)
  let ty = y - 40
  lines.slice(0, 5).forEach((line) => {
    page.drawText(line, {
      x: marginX + 16,
      y: ty,
      size: 9,
      font,
      color: rgb(0.82, 0.88, 1),
    })
    ty -= 12
  })

  y -= 112

  bullets.forEach((b) => {
    const bl = wrapText(b, 95)
    const height = 14 + bl.length * 11

    page.drawRectangle({
      x: marginX,
      y: y - height,
      width: A4.w - marginX * 2,
      height,
      color: rgb(0.06, 0.1, 0.19),
      opacity: 0.96,
    })

    let ly = y - 18
    bl.forEach((line, idx) => {
      page.drawText(idx === 0 ? `• ${line}` : `  ${line}`, {
        x: marginX + 16,
        y: ly,
        size: 8.5,
        font,
        color: rgb(0.84, 0.9, 1),
      })
      ly -= 11
    })

    y -= height + 6
  })
}

// ==================== MAIN EXPORT FUNCTION ====================

export async function generateProfessionalReport(
  reportConfig: ReportConfig,
  selectedTheme: ThemeOption,
  aiGeneratedSections: GeneratedReportSection[],
  modeContent: ModeContent,
): Promise<Blob> {
  console.log('Starting PDF generation...')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const primary = hexToRgb(selectedTheme.primaryColor || '#1e3a8a')
  const accent = hexToRgb(selectedTheme.accentColor || '#06b6d4')

  // 1) Cover
  coverPage(pdf, font, bold, primary, reportConfig, modeContent)

  // 2) A few generic AI–driven sections.
  // (If aiGeneratedSections is empty, we fall back to template text.)
  const bodyText =
    aiGeneratedSections && aiGeneratedSections.length
      ? aiGeneratedSections.map((s) => `${s.title}\n\n${s.body || ''}`).join('\n\n')
      : 'AI did not return sectioned content. This is a template narrative summarising the analysis.'

  sectionPage(
    pdf,
    font,
    bold,
    'Executive Summary',
    bodyText,
    [
      'Overall feasibility and key decision points.',
      'Primary risks and mitigations.',
      'Market, financial, and regulatory highlights.',
    ],
    primary,
    accent,
  )
  // One detailed page per AI section
  if (aiGeneratedSections && aiGeneratedSections.length) {
    aiGeneratedSections.forEach((s, index) => {
      const body = s.body || ''
      const bullets =
        Array.isArray((s as any).bullets) && (s as any).bullets.length
          ? (s as any).bullets.map((b: any) => String(b))
          : []

      sectionPage(
        pdf,
        font,
        bold,
        s.title || `Section ${index + 1}`,
        body,
        bullets,
        primary,
        accent,
      )
    })
  }

  sectionPage(
    pdf,
    font,
    bold,
    reportConfig.analysisType === 'contract'
      ? 'Contract Risk & Obligations'
      : 'Land Risk & Compliance',
    'Detailed risk analysis based on AI inspection of the uploaded documents.',
    ['Regulatory / title / planning risk', 'Market and absorption risk', 'Execution / cost overrun risk'],
    primary,
    accent,
  )

  // 3) Append basic appendix pages until close to target page count
  const target = Math.min(200, Math.max(8, modeContent.pages || 30))
  console.log(`Target pages: ${target}`)

  const appendixContent = [
    {
      title: 'Appendix: Data Sources & Methodology',
      body: 'This report is generated using AI analysis of the uploaded files combined with standard feasibility templates.',
      bullets: [
        'Document parsing and extraction using Groq LLM.',
        'Cross–checking against planning and regulatory templates.',
        'Heuristics tuned for Indian land and contract feasibility.',
      ],
    },
    {
      title: 'Appendix: Disclaimer',
      body: 'AI outputs should always be reviewed by qualified professionals before making investment decisions.',
      bullets: [
        'Not a substitute for statutory approvals.',
        'Not a substitute for formal valuation or legal opinions.',
        'Market conditions and regulations are subject to change.',
      ],
    },
  ]

  let appendixCount = 0
  while (pdf.getPageCount() < target && appendixCount < appendixContent.length) {
    const appendix = appendixContent[appendixCount]
    sectionPage(pdf, font, bold, appendix.title, appendix.body, appendix.bullets, primary, accent)
    appendixCount++
  }

  const total = pdf.getPageCount()
  console.log(`📚 Total pages: ${total} (Target was ${target})`)

  // 4) Footers on all pages
  for (let i = 0; i < total; i++) {
    const page = pdf.getPage(i)
    footerBar(page, font, i, total)
  }

  const bytes = await pdf.save()
  // pdf-lib's save() returns a Uint8Array typed against ArrayBufferLike, which
  // TS's DOM lib no longer accepts directly as a BlobPart (it wants a view
  // backed specifically by ArrayBuffer, not SharedArrayBuffer). Copy into a
  // fresh ArrayBuffer-backed view so this is a real fix, not a type cast.
  const pdfBuffer = new Uint8Array(bytes)
  return new Blob([pdfBuffer], { type: 'application/pdf' })
}

// Default export
export default generateProfessionalReport

// ==================== BACKWARDS-COMPATIBLE ALIAS ====================

// Some existing UI or old bundle code refers to `generateProfessionalPDF`.
// Provide a thin alias so those calls keep working.
export async function generateProfessionalPDF(
  reportConfig: ReportConfig,
  selectedTheme: ThemeOption,
  aiGeneratedSections: GeneratedReportSection[],
  modeContent: ModeContent,
): Promise<Blob> {
  return generateProfessionalReport(reportConfig, selectedTheme, aiGeneratedSections, modeContent)
}

// Global window export for any legacy global usage
declare global {
  interface Window {
    _generateProfessionalReport?: typeof generateProfessionalReport
    generateProfessionalPDF?: typeof generateProfessionalPDF
  }
}

if (typeof window !== 'undefined') {
  ;(window as any)._generateProfessionalReport = generateProfessionalReport
  ;(window as any).generateProfessionalPDF = generateProfessionalPDF
}
