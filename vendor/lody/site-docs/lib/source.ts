import { loader } from 'fumadocs-core/source';
import { docsEn, docsZh } from '@site/.source/server';

export const sourceEn = loader({
  baseUrl: '/docs',
  source: docsEn.toFumadocsSource(),
});

export const sourceZh = loader({
  baseUrl: '/zh/docs',
  source: docsZh.toFumadocsSource(),
});
