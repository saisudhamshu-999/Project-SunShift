import { useEffect } from 'react'
import { Footer } from '@/components/layout/Footer'
import { Architecture } from '@/sections/Architecture'
import { Coordination } from '@/sections/Coordination'
import { CoreLoop } from '@/sections/CoreLoop'
import { CropWater } from '@/sections/CropWater'
import { DeploymentModes } from '@/sections/DeploymentModes'
import { DigitalTwin } from '@/sections/DigitalTwin'
import { Fairness } from '@/sections/Fairness'
import { Farmer } from '@/sections/Farmer'
import { Feeder } from '@/sections/Feeder'
import { FinalCta } from '@/sections/FinalCta'
import { Hardware } from '@/sections/Hardware'
import { Hero } from '@/sections/Hero'
import { Economics } from '@/sections/Economics'
import { Impact } from '@/sections/Impact'
import { IndiaFit, WhoDeploys } from '@/sections/IndiaFit'
import { NotJustWeather } from '@/sections/NotJustWeather'
import { NotMagic } from '@/sections/NotMagic'
import { Optimiser } from '@/sections/Optimiser'
import { Problem } from '@/sections/Problem'
import { Resilience } from '@/sections/Resilience'
import { Roadmap } from '@/sections/Roadmap'
import { Season } from '@/sections/Season'
import { SoilBalance } from '@/sections/SoilBalance'
import { SolarModel } from '@/sections/SolarModel'
import { TechCredibility } from '@/sections/TechCredibility'
import { WeatherInterrupt } from '@/sections/WeatherInterrupt'
import { usePlan } from '@/state/plan'

/** The story, in ten acts: sun, problem, feeder, system, model, optimiser, farmer, control, impact, future. */
export default function Home() {
  const ensure = usePlan((s) => s.ensure)
  useEffect(() => ensure(), [ensure])
  return (
    <>
      {/* I · The sun */}
      <Hero />
      {/* II · The problem */}
      <Problem />
      {/* III · The feeder */}
      <Feeder />
      <Coordination />
      {/* IV · The system */}
      <CoreLoop />
      {/* V · The model */}
      <NotJustWeather />
      <CropWater />
      <SoilBalance />
      <SolarModel />
      {/* VI · The optimiser */}
      <Optimiser />
      <Fairness />
      <WeatherInterrupt />
      {/* VII · The farmer */}
      <Farmer />
      {/* VIII · The control */}
      <Hardware />
      <DeploymentModes />
      {/* IX · The impact */}
      <Impact />
      <Economics />
      <Season />
      <DigitalTwin />
      {/* X · The future */}
      <IndiaFit />
      <WhoDeploys />
      <Architecture />
      <TechCredibility />
      <Resilience />
      <NotMagic />
      <Roadmap />
      <FinalCta />
      <Footer />
    </>
  )
}
