import { useEffect, useRef } from 'react';

const SCROLL_THRESHOLD = 50; // Расстояние от края в пикселях для активации скролла
const SCROLL_SPEED = 10; // Скорость скролла в пикселях

export function useAutoScroll(isDragging: boolean) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mouseYRef = useRef<number>(0);

  useEffect(() => {
    if (!isDragging) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      mouseYRef.current = e.clientY;
    };

    const autoScroll = () => {
      if (!scrollContainerRef.current) {
        animationFrameRef.current = requestAnimationFrame(autoScroll);
        return;
      }

      const container = scrollContainerRef.current;
      const rect = container.getBoundingClientRect();
      const mouseY = mouseYRef.current;

      // Проверяем, находится ли курсор в пределах контейнера
      if (mouseY < rect.top || mouseY > rect.bottom) {
        animationFrameRef.current = requestAnimationFrame(autoScroll);
        return;
      }

      const distanceFromTop = mouseY - rect.top;
      const distanceFromBottom = rect.bottom - mouseY;

      // Скролл вверх
      if (distanceFromTop < SCROLL_THRESHOLD && container.scrollTop > 0) {
        const intensity = 1 - distanceFromTop / SCROLL_THRESHOLD;
        container.scrollTop -= SCROLL_SPEED * intensity;
      }
      // Скролл вниз
      else if (distanceFromBottom < SCROLL_THRESHOLD) {
        const maxScroll = container.scrollHeight - container.clientHeight;
        if (container.scrollTop < maxScroll) {
          const intensity = 1 - distanceFromBottom / SCROLL_THRESHOLD;
          container.scrollTop += SCROLL_SPEED * intensity;
        }
      }

      animationFrameRef.current = requestAnimationFrame(autoScroll);
    };

    document.addEventListener('mousemove', handleMouseMove);
    animationFrameRef.current = requestAnimationFrame(autoScroll);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isDragging]);

  return scrollContainerRef;
}
