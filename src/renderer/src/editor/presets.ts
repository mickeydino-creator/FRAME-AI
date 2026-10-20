/**
 * Built-in generated assets: text styles, shapes, backgrounds and multi-layer
 * templates. Each preset expands into ordinary editing commands.
 */
import type { Command } from '../../../shared/commands'
import type { AspectRatio, ClipAnimation, Fill, ShapeKind, TextStyle } from '../../../shared/types'

export interface TextPreset {
  id: string
  label: string
  style: Partial<TextStyle>
  y: (h: number) => number
  animIn: ClipAnimation
  animOut: ClipAnimation
  duration: number
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'title',
    label: 'Title',
    style: { text: 'Big Title', fontSize: 140, fontWeight: 800, fontFamily: 'Segoe UI' },
    y: () => 0,
    animIn: { preset: 'pop', duration: 0.6 },
    animOut: { preset: 'fade', duration: 0.4 },
    duration: 4
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    style: { text: 'A short supporting line', fontSize: 64, fontWeight: 400, color: '#d7dae0' },
    y: (h) => h * 0.12,
    animIn: { preset: 'slide-up', duration: 0.6 },
    animOut: { preset: 'fade', duration: 0.4 },
    duration: 4
  },
  {
    id: 'lower-third',
    label: 'Lower Third',
    style: {
      text: 'Jane Cooper\nCreative Director',
      fontSize: 48,
      fontWeight: 600,
      align: 'left',
      backgroundColor: 'rgba(10,10,12,0.82)',
      backgroundPadding: 28,
      backgroundRadius: 6
    },
    y: (h) => h * 0.32,
    animIn: { preset: 'wipe-right', duration: 0.5 },
    animOut: { preset: 'wipe-left', duration: 0.4 },
    duration: 5
  },
  {
    id: 'caption',
    label: 'Caption',
    style: {
      text: 'Spoken caption text appears here',
      fontSize: 54,
      fontWeight: 700,
      strokeColor: '#000000',
      strokeWidth: 5
    },
    y: (h) => h * 0.36,
    animIn: { preset: 'none', duration: 0.3 },
    animOut: { preset: 'none', duration: 0.3 },
    duration: 3
  },
  {
    id: 'cta',
    label: 'Call to Action',
    style: {
      text: 'SHOP NOW',
      fontSize: 64,
      fontWeight: 800,
      letterSpacing: 6,
      color: '#0b0b0c',
      backgroundColor: '#ffd23f',
      backgroundPadding: 30,
      backgroundRadius: 40
    },
    y: (h) => h * 0.25,
    animIn: { preset: 'pop', duration: 0.5 },
    animOut: { preset: 'scale', duration: 0.4 },
    duration: 3
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    style: { text: 'Typing out a message…', fontSize: 72, fontWeight: 500, fontFamily: 'Consolas' },
    y: () => 0,
    animIn: { preset: 'typewriter', duration: 1.5 },
    animOut: { preset: 'fade', duration: 0.4 },
    duration: 4
  }
]

export const SHAPE_PRESETS: { id: ShapeKind; label: string; width: number; height: number; cornerRadius?: number }[] = [
  { id: 'rect', label: 'Rectangle', width: 640, height: 360, cornerRadius: 24 },
  { id: 'ellipse', label: 'Circle', width: 400, height: 400 },
  { id: 'triangle', label: 'Triangle', width: 400, height: 360 },
  { id: 'line', label: 'Line', width: 700, height: 10, cornerRadius: 5 },
  { id: 'star', label: 'Star', width: 420, height: 420 }
]

export const BACKGROUND_PRESETS: { id: string; label: string; fill: Fill }[] = [
  { id: 'black', label: 'Black', fill: { kind: 'solid', color: '#000000' } },
  { id: 'white', label: 'White', fill: { kind: 'solid', color: '#f4f4f2' } },
  { id: 'night', label: 'Midnight', fill: { kind: 'linear', colors: ['#0f2027', '#203a43', '#2c5364'], angle: 135 } },
  { id: 'sunset', label: 'Sunset', fill: { kind: 'linear', colors: ['#ff512f', '#dd2476'], angle: 45 } },
  { id: 'ocean', label: 'Ocean', fill: { kind: 'linear', colors: ['#2193b0', '#6dd5ed'], angle: 90 } },
  { id: 'violet', label: 'Violet', fill: { kind: 'linear', colors: ['#41295a', '#2f0743'], angle: 160 } },
  { id: 'lime', label: 'Lime', fill: { kind: 'linear', colors: ['#a8e063', '#56ab2f'], angle: 120 } },
  { id: 'spot', label: 'Spotlight', fill: { kind: 'radial', colors: ['#3a3f4b', '#0b0c0f'] } }
]

export function fillCss(fill: Fill): string {
  if (fill.kind === 'solid') return fill.color
  if (fill.kind === 'linear') return `linear-gradient(${fill.angle + 90}deg, ${fill.colors.join(', ')})`
  return `radial-gradient(circle, ${fill.colors.join(', ')})`
}

export interface Template {
  id: string
  label: string
  description: string
  /** Commands placing the template at `start`; the API routes every layer onto one new track. */
  build(start: number, size: { width: number; height: number; aspect: AspectRatio }): Command[]
}

export const TEMPLATES: Template[] = [
  {
    id: 'promo-intro',
    label: 'Promo Intro',
    description: 'Gradient background, bold title, subtitle and accent bar',
    build: (start, { width, height }) => {
      const portrait = height > width
      return [
        { type: 'addTrack', kind: 'video', name: 'Promo BG', index: 0 },
        {
          type: 'addClip',
          clip: { type: 'background', name: 'Promo BG', duration: 5, fill: { kind: 'linear', colors: ['#141e30', '#243b55'], angle: 135 } },
          start
        },
        {
          type: 'addClip',
          clip: {
            type: 'shape',
            name: 'Accent bar',
            duration: 4.6,
            shape: { shape: 'line', width: portrait ? 520 : 420, height: 12, fill: { kind: 'solid', color: '#ffb547' }, strokeColor: '#fff', strokeWidth: 0, cornerRadius: 6 },
            transform: { x: 0, y: -130, scale: 1, rotation: 0, opacity: 1 },
            animIn: { preset: 'wipe-right', duration: 0.6 },
            animOut: { preset: 'fade', duration: 0.4 }
          },
          start: start + 0.2
        },
        {
          type: 'addText',
          text: 'INTRODUCING',
          style: { fontSize: 54, fontWeight: 600, letterSpacing: 14, color: '#ffb547' },
          transform: { y: -60 },
          start: start + 0.3,
          duration: 4.5,
          animIn: { preset: 'slide-up', duration: 0.6 },
          animOut: { preset: 'fade', duration: 0.4 }
        },
        {
          type: 'addText',
          text: 'Your Product',
          style: { fontSize: portrait ? 130 : 150, fontWeight: 800 },
          transform: { y: 60 },
          start: start + 0.6,
          duration: 4.2,
          animIn: { preset: 'pop', duration: 0.6 },
          animOut: { preset: 'fade', duration: 0.4 }
        },
        {
          type: 'addText',
          text: 'Faster. Simpler. Better.',
          style: { fontSize: 52, fontWeight: 400, color: '#c9d1e0' },
          transform: { y: 180 },
          start: start + 1.1,
          duration: 3.7,
          animIn: { preset: 'fade', duration: 0.7 },
          animOut: { preset: 'fade', duration: 0.4 }
        }
      ]
    }
  },
  {
    id: 'sale-ad',
    label: 'Sale Ad',
    description: 'Punchy discount ad with badge and call to action',
    build: (start, { width, height }) => {
      const portrait = height > width
      return [
        { type: 'addTrack', kind: 'video', name: 'Sale', index: 0 },
        {
          type: 'addClip',
          clip: { type: 'background', name: 'Sale BG', duration: 6, fill: { kind: 'linear', colors: ['#ff512f', '#dd2476'], angle: 45 } },
          start
        },
        {
          type: 'addClip',
          clip: {
            type: 'shape',
            name: 'Badge',
            duration: 5.4,
            shape: { shape: 'star', width: 380, height: 380, fill: { kind: 'solid', color: '#ffd23f' }, strokeColor: '#fff', strokeWidth: 0, cornerRadius: 0 },
            transform: { x: portrait ? 0 : -460, y: portrait ? -420 : 0, scale: 1, rotation: -12, opacity: 1 },
            animIn: { preset: 'rotate', duration: 0.7 },
            animOut: { preset: 'scale', duration: 0.4 }
          },
          start: start + 0.2
        },
        {
          type: 'addText',
          text: '50%\nOFF',
          style: { fontSize: 92, fontWeight: 900, color: '#1a1a1a', lineHeight: 1 },
          transform: { x: portrait ? 0 : -460, y: portrait ? -420 : 0, rotation: -12 },
          start: start + 0.5,
          duration: 5.1,
          animIn: { preset: 'pop', duration: 0.5 },
          animOut: { preset: 'scale', duration: 0.4 }
        },
        {
          type: 'addText',
          text: 'SUMMER\nSALE',
          style: { fontSize: portrait ? 150 : 170, fontWeight: 900, lineHeight: 0.95, align: portrait ? 'center' : 'left' },
          transform: { x: portrait ? 0 : 200, y: portrait ? 40 : -40 },
          start: start + 0.4,
          duration: 5.2,
          animIn: { preset: 'slide-left', duration: 0.6 },
          animOut: { preset: 'fade', duration: 0.4 }
        },
        {
          type: 'addText',
          text: 'SHOP NOW',
          style: { fontSize: 56, fontWeight: 800, letterSpacing: 6, color: '#dd2476', backgroundColor: '#ffffff', backgroundPadding: 28, backgroundRadius: 40 },
          transform: { x: portrait ? 0 : 200, y: portrait ? 420 : 250 },
          start: start + 1.4,
          duration: 4.2,
          animIn: { preset: 'pop', duration: 0.5 },
          animOut: { preset: 'fade', duration: 0.4 }
        }
      ]
    }
  },
  {
    id: 'title-sequence',
    label: 'Title Sequence',
    description: 'Cinematic dark title with typewriter credit',
    build: (start) => [
      { type: 'addTrack', kind: 'video', name: 'Titles', index: 0 },
      {
        type: 'addClip',
        clip: { type: 'background', name: 'Titles BG', duration: 7, fill: { kind: 'radial', colors: ['#2b2f3a', '#050506'] }, fadeIn: 1, fadeOut: 1 },
        start
      },
      {
        type: 'addText',
        text: 'A FRAME AI FILM',
        style: { fontSize: 40, fontWeight: 400, letterSpacing: 18, color: '#9aa3b2' },
        transform: { y: -110 },
        start: start + 0.8,
        duration: 5.4,
        animIn: { preset: 'typewriter', duration: 1.2 },
        animOut: { preset: 'fade', duration: 0.8 }
      },
      {
        type: 'addText',
        text: 'THE LONG ROAD',
        style: { fontSize: 150, fontWeight: 300, letterSpacing: 24, fontFamily: 'Georgia' },
        transform: { y: 20 },
        start: start + 2,
        duration: 4.4,
        animIn: { preset: 'blur', duration: 1.2 },
        animOut: { preset: 'fade', duration: 0.8 }
      }
    ]
  }
]
