import type { RefObject } from 'react'
import type { CropKey } from '@/api/types'
import type { Tier } from '@/lib/device'
import type { Dynamics } from './dynamics'
import { EnergyFlow, Rain, SoilProfile, WaterFlow } from './Effects'
import { Environment } from './Environment'
import { Fields } from './Fields'
import { Grid, SolarPlant, Substation } from './Infrastructure'
import { Surroundings, Terrain } from './Terrain'

export interface WorldProps {
  dyn: RefObject<Dynamics>
  tier: Tier
  crops?: Record<number, CropKey>
  das?: Record<number, number>
  selected?: number | null
  onSelect?: (id: number) => void
  interactive?: boolean
  soilProfile?: boolean
  rain?: boolean
  shadows?: boolean
}

/** The whole solarised feeder: landscape, farms, solar plant, network and live effects. */
export function World({ dyn, tier, crops, das, selected, onSelect, interactive, soilProfile, rain, shadows }: WorldProps) {
  return (
    <>
      <Environment dyn={dyn} shadows={shadows} />
      <Terrain tier={tier} />
      <Surroundings tier={tier} />
      <Fields dyn={dyn} tier={tier} crops={crops} das={das} selected={selected} onSelect={onSelect} interactive={interactive} />
      <SolarPlant dyn={dyn} tier={tier} />
      <Substation />
      <Grid dyn={dyn} tier={tier} />
      <EnergyFlow dyn={dyn} tier={tier} />
      <WaterFlow dyn={dyn} tier={tier} />
      {rain && <Rain dyn={dyn} />}
      {soilProfile && <SoilProfile dyn={dyn} />}
    </>
  )
}
