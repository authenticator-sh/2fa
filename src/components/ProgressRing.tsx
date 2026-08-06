interface ProgressRingProps {
  remaining: number;
  period: number;
  /** Outer diameter in px. The compact row needs a smaller ring than the card. */
  size?: number;
}

export function ProgressRing({ remaining, period, size = 40 }: ProgressRingProps) {
  // A record can carry a period of 0 or NaN — an old import, or the manual form
  // before it validated the field. Dividing by it painted `strokeDashoffset="NaN"`
  // and a literal "NaN" inside the ring. The TOTP default is the honest guess.
  const safePeriod = Number.isFinite(period) && period > 0 ? period : 30;
  const safeRemaining = Number.isFinite(remaining) ? remaining : safePeriod;
  const percentage = (safeRemaining / safePeriod) * 100;
  const isLowTime = safeRemaining <= 5;
  const center = size / 2;
  const radius = center - 4;
  // Derived from the radius the circle actually uses. It used to be computed
  // from r=18 while the circle was drawn at r=16, so the dash array was ~12%
  // too long and the ring never quite reached empty before resetting.
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          className="text-gray-200 dark:text-dark-600"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={`transition-all duration-1000 ${
            isLowTime ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'
          }`}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          className={`font-mono font-semibold ${size < 32 ? 'text-[10px]' : 'text-xs'} ${
            isLowTime ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'
          }`}
        >
          {safeRemaining}
        </span>
      </div>
    </div>
  );
}
