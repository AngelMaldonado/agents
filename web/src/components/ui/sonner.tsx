// Toasts (sonner), in the app's theme and fonts.
import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/lib/theme';

export function Toaster() {
	const { mode } = useTheme();
	return (
		<Sonner
			theme={mode}
			position="bottom-right"
			richColors
			toastOptions={{ classNames: { toast: 'font-sans text-sm', description: 'text-xs' } }}
		/>
	);
}
