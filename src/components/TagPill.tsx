import { Badge } from '@abumble/design-system/components/Badge';

export function TagPill({ tag }: { tag: string }) {
	return (
		<a href={`/tags/${tag}`} className="tag-pill">
			<Badge variant="outline" className="transition-colors hover:border-foreground hover:text-foreground">
				{tag}
			</Badge>
		</a>
	);
}
