import {
  defineCollections,
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from 'fumadocs-mdx/config';
import { z } from 'zod';

const docsSchema = frontmatterSchema.extend({
  title: z.string(),
  description: z.string().optional(),
});

const changelogSchema = z.object({
  title: z.string(),
  version: z.string(),
  date: z.union([z.string(), z.date()]).optional(),
  description: z.string().optional(),
  draft: z.boolean().optional(),
});

const blogSchema = z.object({
  title: z.string(),
  date: z.union([z.string(), z.date()]).optional(),
  author: z.string().optional(),
  authorLink: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  tag: z.string().optional(),
  draft: z.boolean().optional(),
});

export const docsEn = defineDocs({
  dir: 'content/docs/en',
  docs: {
    schema: docsSchema,
  },
});

export const docsZh = defineDocs({
  dir: 'content/docs/zh',
  docs: {
    schema: docsSchema,
  },
});

export const changelogEn = defineCollections({
  type: 'doc',
  dir: 'content/changelog/en',
  schema: changelogSchema,
});

export const changelogZh = defineCollections({
  type: 'doc',
  dir: 'content/changelog/zh',
  schema: changelogSchema,
});

export const blogEn = defineCollections({
  type: 'doc',
  dir: 'content/blog/en',
  schema: blogSchema,
});

export const blogZh = defineCollections({
  type: 'doc',
  dir: 'content/blog/zh',
  schema: blogSchema,
});

const pageSchema = frontmatterSchema.extend({
  title: z.string(),
  description: z.string().optional(),
});

export const pagesEn = defineCollections({
  type: 'doc',
  dir: 'content/pages/en',
  schema: pageSchema,
});

export const pagesZh = defineCollections({
  type: 'doc',
  dir: 'content/pages/zh',
  schema: pageSchema,
});

export default defineConfig({});
