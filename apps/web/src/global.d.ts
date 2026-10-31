import * as React from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        hidden?: boolean;
      };
    }
  }

  interface Window {
    paypal?: {
      createInstance(options: { clientId: string; components?: string[] }): Promise<{
        findEligibleMethods(options?: { currencyCode?: string }): Promise<{
          isEligible(method: string): boolean;
        }>;
        createPayPalOneTimePaymentSession(options: {
          onApprove: (data: { orderId: string; payerId: string }) => Promise<void>;
          onCancel: (data: { orderId: string }) => void;
          onError: (error: { code: string; message: string }) => void;
          orderId?: string;
        }): {
          start(options?: { presentationMode?: string }, orderPromise?: Promise<unknown>): Promise<void>;
        };
      }>;
    };
  }
}

export {};
