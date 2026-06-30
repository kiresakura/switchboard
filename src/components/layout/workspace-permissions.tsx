"use client";

import { createContext, useContext } from "react";

type PermissionMap = Record<string, boolean>;

const PermissionsContext = createContext<PermissionMap>({});

export function WorkspacePermissionsProvider({
  permissions,
  children,
}: {
  permissions: PermissionMap;
  children: React.ReactNode;
}) {
  return (
    <PermissionsContext.Provider value={permissions}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions(): PermissionMap {
  return useContext(PermissionsContext);
}

export function useHasPermission(...keys: string[]): boolean {
  const perms = useContext(PermissionsContext);
  return keys.some((k) => perms[k]);
}
