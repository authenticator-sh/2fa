import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { getFaqItems } from '@/utils/faqTranslations';

interface FAQItemProps {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
  itemRef?: React.Ref<HTMLDivElement>;
}

function FAQItem({ question, answer, isOpen, onToggle, itemRef }: FAQItemProps) {
  return (
    <div ref={itemRef} className="border-b border-gray-200 dark:border-dark-600 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full py-3 px-4 flex items-start justify-between gap-3 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors text-left"
      >
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1">{question}</span>
        {isOpen ? (
          <ChevronUp className="text-gray-500 dark:text-gray-400 flex-shrink-0 mt-0.5" size={16} />
        ) : (
          <ChevronDown className="text-gray-500 dark:text-gray-400 flex-shrink-0 mt-0.5" size={16} />
        )}
      </button>
      {isOpen && (
        <div className="px-4 pb-3">
          <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-line">{answer}</p>
        </div>
      )}
    </div>
  );
}

interface FAQProps {
  language: Language;
  openId?: string | null;
}

export function FAQ({ language, openId }: FAQProps) {
  const t = createT(language);
  const faqs = getFaqItems(language);

  const idIndex = openId ? faqs.findIndex((f) => f.id === openId) : -1;
  const [openIndex, setOpenIndex] = useState<number | null>(idIndex >= 0 ? idIndex : null);
  const targetRef = useRef<HTMLDivElement>(null);

  // When asked to open a specific item (e.g. from the time-sync alert), expand it
  // and scroll it into view within the FAQ's scroll container.
  useEffect(() => {
    if (idIndex >= 0) {
      setOpenIndex(idIndex);
      targetRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [idIndex]);

  return (
    <div className="p-4 bg-gray-50 dark:bg-dark-800 border-b border-gray-200 dark:border-dark-600">
      <h3 className="text-gray-900 dark:text-gray-100 font-medium mb-3 text-sm">{t('faq.title')}</h3>
      <div className="bg-white dark:bg-dark-900 rounded-lg border border-gray-200 dark:border-dark-600 overflow-hidden max-h-[400px] overflow-y-auto">
        {faqs.map((faq, index) => (
          <FAQItem
            key={index}
            itemRef={index === idIndex ? targetRef : undefined}
            question={faq.question}
            answer={faq.answer}
            isOpen={openIndex === index}
            onToggle={() => setOpenIndex(openIndex === index ? null : index)}
          />
        ))}
      </div>
    </div>
  );
}
