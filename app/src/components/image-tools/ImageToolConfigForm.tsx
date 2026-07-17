import { Controller, useForm } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { ImageToolSchemaDefinition } from '@/config/imageToolSchemas';

interface ImageToolConfigFormProps {
  definition: ImageToolSchemaDefinition;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

function stopCanvasEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function ImageToolConfigForm({ definition, value, onChange }: ImageToolConfigFormProps) {
  const form = useForm<Record<string, unknown>>({
    defaultValues: value,
    values: value,
    mode: 'onChange',
  });

  return (
    <div
      className="space-y-4 nodrag nopan nowheel"
      onPointerDownCapture={stopCanvasEvent}
      onMouseDownCapture={stopCanvasEvent}
      onTouchStartCapture={stopCanvasEvent}
      onWheelCapture={stopCanvasEvent}
    >
      {definition.fields.map((field) => (
        <Controller
          key={field.key}
          control={form.control}
          name={field.key}
          render={({ field: controllerField }) => {
            const error = form.formState.errors[field.key]?.message;
            return (
              <div className="space-y-2 nodrag nopan nowheel">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium text-[#ececec]">{field.label}</label>
                  <span className="text-xs text-[#8f8f8f]">{formatFieldValue(controllerField.value)}</span>
                </div>
                {field.description ? <div className="text-xs text-[#8f8f8f]">{field.description}</div> : null}
                {field.type === 'slider' ? (
                  <Slider
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={[Number(controllerField.value ?? field.min ?? 0)]}
                    onValueChange={(next) => {
                      controllerField.onChange(next[0]);
                      void form.trigger(field.key);
                      onChange({ ...form.getValues(), [field.key]: next[0] });
                    }}
                    className="nodrag nopan nowheel"
                  />
                ) : null}
                {field.type === 'number' ? (
                  <Input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={String(controllerField.value ?? '')}
                    onPointerDown={stopCanvasEvent}
                    onMouseDown={stopCanvasEvent}
                    onTouchStart={stopCanvasEvent}
                    onWheel={stopCanvasEvent}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      controllerField.onChange(Number.isFinite(next) ? next : undefined);
                      void form.trigger(field.key);
                      onChange({ ...form.getValues(), [field.key]: Number.isFinite(next) ? next : undefined });
                    }}
                    className="nodrag nopan nowheel bg-[#202020] text-[#f1f1f1]"
                  />
                ) : null}
                {field.type === 'text' ? (
                  <Input
                    value={String(controllerField.value ?? '')}
                    onPointerDown={stopCanvasEvent}
                    onMouseDown={stopCanvasEvent}
                    onTouchStart={stopCanvasEvent}
                    onWheel={stopCanvasEvent}
                    onChange={(event) => {
                      controllerField.onChange(event.target.value);
                      void form.trigger(field.key);
                      onChange({ ...form.getValues(), [field.key]: event.target.value });
                    }}
                    className="nodrag nopan nowheel bg-[#202020] text-[#f1f1f1]"
                  />
                ) : null}
                {field.type === 'select' && field.options ? (
                  <Select
                    value={String(controllerField.value ?? '')}
                    onValueChange={(next) => {
                      controllerField.onChange(next);
                      void form.trigger(field.key);
                      onChange({ ...form.getValues(), [field.key]: next });
                    }}
                  >
                    <SelectTrigger className="nodrag nopan nowheel w-full bg-[#202020] text-[#f1f1f1]">
                      <SelectValue placeholder={`??${field.label}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {field.type === 'switch' ? (
                  <div className="flex items-center justify-between rounded-lg border border-[#3b3b3b] bg-[#202020] px-3 py-2">
                    <span className="text-sm text-[#e9e9e9]">{Boolean(controllerField.value) ? '??' : '??'}</span>
                    <Switch
                      checked={Boolean(controllerField.value)}
                      onCheckedChange={(checked) => {
                        controllerField.onChange(checked);
                        void form.trigger(field.key);
                        onChange({ ...form.getValues(), [field.key]: checked });
                      }}
                    />
                  </div>
                ) : null}
                {error ? <div className="text-xs text-[#f87171]">{String(error)}</div> : null}
              </div>
            );
          }}
        />
      ))}
    </div>
  );
}

function formatFieldValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '??' : '??';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'string') return value;
  return '';
}
