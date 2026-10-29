import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';

export function ThemeToggle() {
	const theme = useTheme();
	const label = theme.mode === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro';
	return <Button type="button" variant="ghost" size="icon" onClick={theme.toggle} aria-label={label} title={label}>
		{theme.mode === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
	</Button>;
}
