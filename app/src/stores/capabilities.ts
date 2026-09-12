import { defineStore } from 'pinia';
import { ref } from 'vue';
import { repository } from '@/data';
import { noCapabilities, type Capabilities, type RolePermission } from '@/data/types';

/**
 * The server's feature snapshot, read once at start-up. Everything starts off, so a screen never offers an action
 * the server would reject; the first answer switches on what is really there.
 */
export const useCapabilitiesStore = defineStore('capabilities', () => {
  const can = ref<Capabilities>(noCapabilities());
  const loaded = ref(false);
  /**
   * The snapshot did not arrive. Every INSTALLATION feature stays off, which is the safe default — but it also
   * means those menus say "Not available on this server" for a server that simply did not answer, so the failure
   * is remembered and somebody can ask again instead of the session being stuck with it. Role permissions are not
   * withheld on a failure: see `noCapabilities`.
   */
  const failed = ref(false);

  async function load() {
    try {
      can.value = await repository.capabilities();
    } catch (error) {
      failed.value = true;
      console.error('capabilities unavailable', error);
      return;
    }
    loaded.value = true;
    failed.value = false;
  }

  /**
   * Whether the caller's ROLE carries one operation. A second question from the installation one: a server that
   * can move files still refuses the move when the role has no `files.move`, and the two produce different
   * sentences — "Not available on this server" against "Your role may not do this".
   */
  function allows(permission: RolePermission): boolean {
    return can.value.allowed.has(permission);
  }

  return { can, loaded, failed, load, allows };
});
