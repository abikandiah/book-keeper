import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { bookSchema } from './content/schema';

const booksCollection = defineCollection({
	loader: glob({ pattern: '**/*.json', base: './src/content/books' }),
	schema: bookSchema,
});

export const collections = {
	books: booksCollection,
};
