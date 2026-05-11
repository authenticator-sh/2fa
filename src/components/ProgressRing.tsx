interface ProgressRingProps {
  remaining: number;
  period: number;
}

export function ProgressRing({ remaining, period }: ProgressRingProps) {
  const percentage = (remaining / period) * 100;
  const isLowTime = remaining <= 5;
  const circumference = 2 * Math.PI * 18;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative w-10 h-10">
      <svg className="transform -rotate-90 w-10 h-10">
        <circle
          cx="20"
          cy="20"
          r="16"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          className="text-gray-200 dark:text-dark-600"
        />
        <circle
          cx="20"
          cy="20"
          r="16"
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
        <span className={`text-xs font-mono font-semibold ${isLowTime ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'}`}>
          {remaining}
        </span>
      </div>
    </div>
  );
}
