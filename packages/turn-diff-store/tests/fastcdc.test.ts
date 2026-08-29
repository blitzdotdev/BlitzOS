import { describe, expect, it } from 'vitest';

import { FASTCDC_PROFILE_ID, fastCdcV2020 } from '../src/fastcdc';

describe(FASTCDC_PROFILE_ID, () => {
  it('matches the checked fastcdc-rs v2020 boundary fixture', () => {
    const bytes = Buffer.allocUnsafe(512 * 1024 + 137);
    let state = 0x9e37_79b9;
    for (let index = 0; index < bytes.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[index] = state & 0xff;
    }

    expect(fastCdcV2020(bytes).map(({ offset, length }) => [offset, length])).toEqual([
      [0, 34_203],
      [34_203, 13_814],
      [48_017, 23_394],
      [71_411, 77_200],
      [148_611, 27_049],
      [175_660, 35_844],
      [211_504, 18_908],
      [230_412, 41_378],
      [271_790, 36_550],
      [308_340, 49_884],
      [358_224, 66_265],
      [424_489, 43_813],
      [468_302, 42_153],
      [510_455, 13_970],
    ]);
  });
});
