import { Spinner } from './Spinner'

export function ProcessingScreen({ label }: { label: string }) {
  return (
    <div className="app-bg flex min-h-dvh items-center justify-center px-6 text-ink dark:text-paper">
      <div className="rise w-full max-w-sm rounded-[28px] bg-paper px-6 py-8 text-center shadow-[0_20px_60px_rgba(20,34,28,0.12)] dark:bg-night-2">
        <Spinner className="size-8 text-moss" />
        <p className="mt-4 font-display text-2xl">{label}</p>
        <p className="mt-2 text-sm text-mist dark:text-paper/60">Working on this photo.</p>
      </div>
    </div>
  )
}
