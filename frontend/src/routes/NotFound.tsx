import { Link } from 'react-router'

export default function NotFound() {
  return (
    <section data-theme="dark" className="theme-surface grid min-h-svh place-items-center">
      <div className="wrap text-center">
        <p className="kicker text-sun">404 · after sunset</p>
        <h1 className="t-display t-xl mt-6">No pump<br />scheduled here.</h1>
        <Link to="/" className="btn btn-sun mt-10">Back to the feeder →</Link>
      </div>
    </section>
  )
}
