// Self-contained leaf sub-components extracted from DccEnvironmentPanel.tsx.
// Moved verbatim — no behavior change.
import { type ReactNode, useEffect, useState } from 'react';
import { ChevronRight, Loader2, ScanLine, Wrench } from 'lucide-react';
import type { DccEngine } from '@/services/dcc/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function StealthActionButton({

  icon: Icon,

  label,

  description,

  loading,

  disabled,

  onClick,

  testId,

  buttonDataEngine,

  action,

  accent = 'neutral',

}: {

  icon: typeof Wrench;

  label: string;

  description: string;

  loading: boolean;

  disabled: boolean;

  onClick: () => void;

  testId?: string;

  buttonDataEngine?: DccEngine;

  action?: string;

  accent?: 'neutral' | 'repair' | 'cleanup';

}) {

  const surfaceClasses = accent === 'repair'

    ? 'border-[#5f4a1d] bg-[#2b210b] text-[#f4d98f] hover:border-[#8d7331] hover:bg-[#382b10]'

    : accent === 'cleanup'

      ? 'border-[#275b49] bg-[#0f241d] text-[#baf7e4] hover:border-[#3d8a71] hover:bg-[#163228]'

      : 'border-[#2d333b] bg-[#0f141a] text-[#c9d1d9] hover:border-[#4b5563] hover:bg-[#18202a]';

  const iconClasses = accent === 'repair'

    ? 'text-[#f0c762]'

    : accent === 'cleanup'

      ? 'text-[#76e7c9]'

      : 'text-[#9fb1c1]';

  return (

    <Tooltip>

      <TooltipTrigger asChild>

        <button

          type="button"

          onClick={onClick}

          disabled={disabled}

          aria-label={label}

          title={label}

          data-testid={testId}

          data-engine={buttonDataEngine}

          data-action={action}

          data-loading={loading ? 'true' : 'false'}

          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all duration-200 hover:-translate-y-0.5 hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-35 ${surfaceClasses} ${loading ? 'opacity-100' : 'opacity-50'}`}

        >

          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className={`h-4 w-4 ${iconClasses}`} />}

        </button>

      </TooltipTrigger>

      <TooltipContent side="top" align="center" className="max-w-[280px] rounded-lg border border-[#30363d] bg-[#11161c] px-3 py-2 text-[#e6edf3] shadow-2xl">

        <div className="text-[11px] font-semibold leading-5 text-[#f0f6fc]">{label}</div>

        <div className="mt-1 text-[11px] leading-5 text-[#9fb0c0]">{description}</div>

      </TooltipContent>

    </Tooltip>

  );

}



export function ActionFeatureCard({

  icon: Icon,

  testId,

  buttonTestId,
  buttonDataEngine,

  title,

  description,

  buttonLabel,

  loading,

  disabled,

  tone,

  onClick,

}: {

  icon: typeof Wrench;

  testId?: string;

  buttonTestId?: string;
  buttonDataEngine?: DccEngine;

  title: string;

  description: string;

  buttonLabel: string;

  loading: boolean;

  disabled: boolean;

  tone: 'repair' | 'cleanup';

  onClick: () => void;

}) {

  const cardClasses = tone === 'repair'

    ? 'border-[#4d3f1c] bg-[#191408]'

    : 'border-[#21483b] bg-[#0d1a16]';

  const titleClasses = tone === 'repair' ? 'text-[#fff2c7]' : 'text-[#d7ffef]';

  const descClasses = tone === 'repair' ? 'text-[#cdbb88]' : 'text-[#9ec7ba]';

  const iconClasses = tone === 'repair' ? 'text-[#f0c762]' : 'text-[#76e7c9]';

  return (

    <div className={`group h-full min-w-0 overflow-hidden rounded-xl border px-3 py-3 opacity-75 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 ${cardClasses}`} data-testid={testId} data-tone={tone}>

      <div className="flex min-h-0 items-start justify-between gap-3">

        <div className="min-w-0 flex-1">

          <div className={`flex items-start gap-2 text-sm font-semibold ${titleClasses}`}>

            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClasses}`} />

            <span className="break-words leading-5">{title}</span>

          </div>

          <div className={`mt-1 max-h-0 overflow-hidden break-words text-[11px] leading-5 opacity-0 transition-all duration-200 group-hover:max-h-24 group-hover:opacity-100 group-focus-within:max-h-24 group-focus-within:opacity-100 ${descClasses}`}>{description}</div>

        </div>

        <StealthActionButton

          icon={Icon}

          label={buttonLabel}

          description={description}

          loading={loading}

          disabled={disabled}

          onClick={onClick}

          testId={buttonTestId}

          buttonDataEngine={buttonDataEngine}

          action={tone}

          accent={tone}

        />

      </div>

    </div>

  );

}



export function CollapsiblePanel({



  title,



  count,



  countLabel,



  children,



  open,



  onToggle,



}: {



  title: string;



  count: number;



  countLabel: string;



  children: ReactNode;



  open?: boolean;



  onToggle?: (open: boolean) => void;



}) {



  const [internalOpen, setInternalOpen] = useState(Boolean(open));



  const expanded = typeof open === 'boolean' ? open : internalOpen;







  useEffect(() => {



    if (typeof open === 'boolean') {



      setInternalOpen(open);



    }



  }, [open]);







  return (



    <div className="rounded-lg border border-[#30363d] bg-[#0d1117]" data-expanded={expanded ? 'true' : 'false'}>



      <button



        type="button"



        onClick={() => {



          const next = !expanded;



          setInternalOpen(next);



          onToggle?.(next);



        }}



        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-3 py-2 text-left"



      >



        <div className="flex min-w-0 items-center gap-2">



          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${expanded ? 'rotate-90' : ''}`} />



          <span className="break-words text-[11px] font-semibold tracking-[0.12em] text-[#8b949e]">{title}</span>



        </div>



        <span className="shrink-0 rounded-full border border-[#2a3138] bg-[#11161d] px-2 py-1 text-[10px] text-[#9fb0c0]">



          {count} {countLabel}



        </span>



      </button>



      {expanded ? (



        <div className="border-t border-[#21262d] px-3 py-3">



          <div className="space-y-2">{children}</div>



        </div>



      ) : null}



    </div>



  );



}







export function StatTile({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {



  return (



    <div className="rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-center text-[11px] text-[#cfcfcf]">



      <div className={`text-sm font-semibold ${valueClassName || ''}`}>{value}</div>



      <div className="break-words">{label}</div>



    </div>



  );



}







export function TogglePill({



  active,



  activeLabel,



  inactiveLabel,



  onClick,



}: {



  active: boolean;



  activeLabel: string;



  inactiveLabel: string;



  onClick: () => void;



}) {



  return (



    <button



      type="button"



      onClick={onClick}



      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${active ? 'bg-[#1e4d39] text-[#bbf7d0]' : 'bg-[#30363d] text-[#d0d0d0]'}`}



    >



      {active ? activeLabel : inactiveLabel}



    </button>



  );



}







export function PanelSelect({



  label,



  value,



  disabled,



  onChange,



  options,



}: {



  label: string;



  value: string;



  disabled?: boolean;



  onChange: (value: string) => void;



  options: Array<{ value: string; label: string }>;



}) {



  return (



    <label className="flex min-h-[82px] min-w-0 flex-col justify-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs text-[#c9d1d9]">



      <span className="flex items-start gap-1.5 font-semibold text-[#e8e8e8]">



        <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />



        <span className="break-words leading-5">{label}</span>



      </span>



      <select



        value={value}



        disabled={disabled}



        onChange={(event) => onChange(event.target.value)}



        className="w-full min-w-0 bg-transparent text-xs leading-5 outline-none disabled:opacity-50"



      >



        {options.map((item) => (



          <option key={`${item.value}-${item.label}`} value={item.value} className="bg-[#242424] text-[#eeeeee]">



            {item.label}



          </option>



        ))}



      </select>



    </label>



  );



}














































