'use client'
import React from 'react'

type IconProps = React.SVGProps<SVGSVGElement>
const Svg = ({ children, ...p }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
)
// Generic primitives
export const CircleCheck = (p: IconProps) => (<Svg {...p}><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></Svg>)
export const TriangleAlert = (p: IconProps) => (<Svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></Svg>)
export const Download = (p: IconProps) => (<Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></Svg>)
export const Upload = (p: IconProps) => (<Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5-5 5 5"/><path d="M12 5v12"/></Svg>)
export const FileText = (p: IconProps) => (<Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/></Svg>)
export const Shield = (p: IconProps) => (<Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></Svg>)
export const Brain = (p: IconProps) => (<Svg {...p}><path d="M12 6a3 3 0 0 0-6 0 3 3 0 0 0-3 3 3 3 0 0 0 3 3h1"/><path d="M12 6a3 3 0 1 1 6 0 3 3 0 0 1 3 3 3 3 0 0 1-3 3h-1"/><path d="M12 6v12"/></Svg>)
export const Eye = (p: IconProps) => (<Svg {...p}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></Svg>)
export const X = (p: IconProps) => (<Svg {...p}><path d="M18 6L6 18M6 6l12 12"/></Svg>)
export const Trash2 = (p: IconProps) => (<Svg {...p}><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></Svg>)
export const Calendar = (p: IconProps) => (<Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></Svg>)
export const MapPin = (p: IconProps) => (<Svg {...p}><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/></Svg>)
export const DollarSign = (p: IconProps) => (<Svg {...p}><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/></Svg>)
export const Table = (p: IconProps) => (<Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></Svg>)
export const TrendingUp = (p: IconProps) => (<Svg {...p}><path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></Svg>)
export const Users = (p: IconProps) => (<Svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></Svg>)
export const Settings = (p: IconProps) => (<Svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 6.04 4.3l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51"/></Svg>)
export const BarChart = (p: IconProps) => (<Svg {...p}><path d="M3 3v18h18"/><rect x="7" y="8" width="3" height="7"/><rect x="12" y="5" width="3" height="10"/><rect x="17" y="12" width="3" height="3"/></Svg>)
export const Clock = (p: IconProps) => (<Svg {...p}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></Svg>)
export const RefreshCw = (p: IconProps) => (<Svg {...p}><path d="M21 12a9 9 0 1 1-9-9 9 9 0 0 1 8.37 5"/><path d="M21 3v6h-6"/></Svg>)
export const BookOpen = (p: IconProps) => (<Svg {...p}><path d="M2 4h8a4 4 0 0 1 4 4v12a4 4 0 0 0-4-4H2z"/><path d="M22 4h-8a4 4 0 0 0-4 4v12a4 4 0 0 1 4-4h8z"/></Svg>)
export const MessageSquare = (p: IconProps) => (<Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></Svg>)

// Heroicons used in visuals/citations
export const ChevronDownIcon = (p: IconProps) => (<Svg {...p}><path d="M6 9l6 6 6-6"/></Svg>)
export const ChevronRightIcon = (p: IconProps) => (<Svg {...p}><path d="M9 18l6-6-6-6"/></Svg>)
export const ClipboardIcon = (p: IconProps) => (<Svg {...p}><rect x="8" y="3" width="8" height="4" rx="1"/><rect x="6" y="7" width="12" height="14" rx="2"/></Svg>)
export const ArrowTopRightOnSquareIcon = (p: IconProps) => (<Svg {...p}><path d="M14 3h7v7"/><path d="M10 14L21 3"/><rect x="3" y="10" width="11" height="11" rx="2"/></Svg>)
export const PhotoIcon = (p: IconProps) => (<Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 15l-5-5-4 4-2-2-5 5"/></Svg>)
export const ArrowsPointingOutIcon = (p: IconProps) => (<Svg {...p}><path d="M3 9V3h6"/><path d="M3 3l8 8"/><path d="M21 15v6h-6"/><path d="M21 21l-8-8"/></Svg>)
export const XMarkIcon = X
export const InformationCircleIcon = (p: IconProps) => (<Svg {...p}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></Svg>)
export const CubeIcon = (p: IconProps) => (<Svg {...p}><path d="M21 16V8l-9-5-9 5v8l9 5 9-5Z"/><path d="M3.27 6.96L12 12l8.73-5.04"/><path d="M12 22V12"/></Svg>)
export const DocumentChartBarIcon = BarChart
export const CheckCircle = CircleCheck
export const AlertTriangle = TriangleAlert
// Loading spinner: circular track + rotating arc, heavier 2.5 stroke than
// this file's default 1.8 (a spinner needs to read at a glance at small
// sizes, same reasoning ConversationSidebar.tsx's own hand-rolled spinner
// already used before this one - consolidated here instead of duplicated
// again, and used in place of lucide-react's Loader2 in ui/button.tsx so
// this app has one icon system, not two, per DESIGN.md's SF-Symbols-derived
// "icon and type are one system" rule).
export const Spinner = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.2" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
)
export default {}
