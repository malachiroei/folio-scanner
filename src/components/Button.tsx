import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary:
    'bg-moss text-paper shadow-[0_8px_20px_rgba(28,107,86,0.22)] hover:bg-moss-bright',
  secondary:
    'bg-paper text-ink ring-1 ring-black/10 hover:bg-white dark:bg-night-2 dark:text-paper dark:ring-white/10 dark:hover:bg-white/5',
  ghost: 'bg-transparent text-ink hover:bg-black/5 dark:text-paper dark:hover:bg-white/8',
  danger: 'bg-copper text-paper hover:bg-copper-bright',
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
}

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: Props) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-[15px] font-semibold transition active:enabled:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
      {...props}
    />
  )
}
