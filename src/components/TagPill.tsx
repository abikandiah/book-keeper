import { Badge } from '@abumble/design-system/components/Badge';

export function TagPill({ tag }: { tag: string }) {
	return (
		<a href={`/tags/${tag}`} className="tag-pill">
			<Badge
				variant="outline"
				className="border-transparent bg-foreground/8 text-foreground transition-colors hover:bg-foreground/15"
			>
				{tag}
			</Badge>
		</a>
	);
}
