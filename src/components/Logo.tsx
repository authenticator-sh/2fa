interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 24, className = '' }: LogoProps) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width={size} height={size}>
      <rect x="0" y="0" width="300" height="300" rx="50" fill="white" />

      <circle cx="150" cy="150" r="125" fill="#4285F4" />

      <g transform="translate(150, 150) scale(5) translate(-14, -14)" fill="white">
        <path d="M21.015,6.986c0,2.627-1.449,4.916-3.593,6.108c3.991,15.362,3.991,15.362,3.991,15.362s-13.619,0-14.144,0
      c4.145-14.989,0,0,4.145-14.989C8.853,12.433,7.042,9.92,7.042,6.986C7.042,3.127,10.169,0,14.028,0
      C17.888,0,21.015,3.127,21.015,6.986z"/>
      </g>
    </svg>

  );
}
