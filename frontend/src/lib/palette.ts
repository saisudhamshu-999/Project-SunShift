import type { CropKey } from '@/api/types'

export const C = {
  ivory: '#f3eee4',
  paper: '#faf7f0',
  sand: '#e5dac5',
  ink: '#15140f',
  graphite: '#2b2925',
  muted: '#6f6857',
  sun: '#f2a900',
  sun2: '#ffc93c',
  crop: '#4c8a3b',
  crop2: '#84b85c',
  water: '#2f74c0',
  water2: '#6aa8e6',
  alert: '#d04a2f',
  earth: '#7a5233',
}

export const CROP_COLOR: Record<CropKey, string> = {
  cotton: '#b8a273',
  maize: '#d0a52b',
  groundnut: '#9a6a3e',
  chilli: '#c4452f',
}

export const CROP_TAG: Record<CropKey, string> = {
  cotton: 'COT',
  maize: 'MAI',
  groundnut: 'GNT',
  chilli: 'CHL',
}

export const PRIORITY_COLOR: Record<string, string> = {
  LOW: '#8a8270',
  MEDIUM: '#2f74c0',
  HIGH: '#e08a00',
  CRITICAL: '#d04a2f',
}
