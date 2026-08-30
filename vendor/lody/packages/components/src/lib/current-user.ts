import { z } from 'zod';

export const CurrentUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  image: z.string().nullable().optional(),
});

export type CurrentUser = z.infer<typeof CurrentUserSchema>;

const SessionUserSchema = z
  .object({
    id: z.string().min(1).optional(),
    _id: z.string().min(1).optional(),
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
  })
  .refine((value) => Boolean(value.id || value._id), {
    message: 'Session user is missing both id and _id',
  });

export function normalizeCurrentUserFromSessionUser(sessionUser: unknown): CurrentUser {
  const parsed = SessionUserSchema.parse(sessionUser);
  return CurrentUserSchema.parse({
    id: parsed.id ?? parsed._id,
    email: parsed.email,
    name: parsed.name,
    image: parsed.image,
  });
}
