import { defineStore } from 'pinia';
import { ref } from 'vue';
import { repository } from '@/data';
import { noCapabilities, type Capabilities } from '@/data/types';

/**
 * The server's feature snapshot, read once at start-up. Everything starts off, so a screen never offers an action
 * the server would reject; the first answer switches on what is really there.
 */
export const useCapabilitiesStore = defineStore('capabilities', () => {
  const can = ref<Capabilities>(noCapabilities());
  const loaded = ref(false);

  async function load() {
    can.value = await repository.capabilities();
    loaded.value = true;
  }

  return { can, loaded, load };
});
