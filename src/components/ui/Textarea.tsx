import { TextareaHTMLAttributes, forwardRef, useId } from "react";
import { clsx } from "@/lib/clsx";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, id, className, ...props }, ref) => {
    const generatedId = useId();
    const textareaId = id ?? generatedId;
    const errorId = `${textareaId}-error`;

    return (
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={textareaId}
          className="text-sm font-medium text-slate-700"
        >
          {label}
        </label>
        <textarea
          ref={ref}
          id={textareaId}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          className={clsx(
            "rounded-md border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400",
            "focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-slate-900",
            error ? "border-red-500" : "border-slate-300",
            className
          )}
          {...props}
        />
        {error && (
          <p id={errorId} className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
