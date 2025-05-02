"use client"

import { isManual, isStripe, isMercury } from "@lib/constants"
import { placeOrder } from "@lib/data/cart"
import { HttpTypes } from "@medusajs/types"
import { Button } from "@medusajs/ui"
import { useElements, useStripe } from "@stripe/react-stripe-js"
import React, { useState } from "react"
import ErrorMessage from "../error-message"

import { CardanoWallet, useWallet } from "@meshsdk/react"
import { MeshTxBuilder } from "@meshsdk/core"
import { sdk } from "@lib/config"

type SlotConfig = {
  zeroTime: number
  zeroSlot: number
  slotLength: number
}

const wallet_network = process.env.WALLET_NETWORK || "preprod"

const slotConfig = (() => {
  switch (wallet_network) {
    case "mainnet":
      return {
        zeroTime: 1596059091000,
        zeroSlot: 4492800,
        slotLength: 1000,
      }
    case "preprod":
      return {
        zeroTime: 1655769600000,
        zeroSlot: 86400,
        slotLength: 1000,
      }
    case "preview":
      return {
        zeroTime: 1666656000000,
        zeroSlot: 0,
        slotLength: 1000,
      }
    default:
      return {
        zeroTime: 0,
        zeroSlot: 0,
        slotLength: 1000,
      }
  }
})()

type PaymentButtonProps = {
  cart: HttpTypes.StoreCart
  "data-testid": string
}

const PaymentButton: React.FC<PaymentButtonProps> = ({
  cart,
  "data-testid": dataTestId,
}) => {
  const notReady =
    !cart ||
    !cart.shipping_address ||
    !cart.billing_address ||
    !cart.email ||
    (cart.shipping_methods?.length ?? 0) < 1

  const paymentSession = cart.payment_collection?.payment_sessions?.[0]

  switch (true) {
    case isStripe(paymentSession?.provider_id):
      return (
        <StripePaymentButton
          notReady={notReady}
          cart={cart}
          data-testid={dataTestId}
        />
      )
    case isManual(paymentSession?.provider_id):
      return (
        <ManualTestPaymentButton notReady={notReady} data-testid={dataTestId} />
      )
    case isMercury(paymentSession?.provider_id):
      return (
        <MercuryPaymentButton
          notReady={notReady}
          cart={cart}
          data-testid={dataTestId}
        />
      )
    default:
      return <Button disabled>Select a payment method</Button>
  }
}

const StripePaymentButton = ({
  cart,
  notReady,
  "data-testid": dataTestId,
}: {
  cart: HttpTypes.StoreCart
  notReady: boolean
  "data-testid"?: string
}) => {
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onPaymentCompleted = async () => {
    await placeOrder()
      .catch((err) => {
        setErrorMessage(err.message)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  const stripe = useStripe()
  const elements = useElements()
  const card = elements?.getElement("card")

  const session = cart.payment_collection?.payment_sessions?.find(
    (s) => s.status === "pending"
  )

  const disabled = !stripe || !elements ? true : false

  const handlePayment = async () => {
    setSubmitting(true)

    if (!stripe || !elements || !card || !cart) {
      setSubmitting(false)
      return
    }

    await stripe
      .confirmCardPayment(session?.data.client_secret as string, {
        payment_method: {
          card: card,
          billing_details: {
            name:
              cart.billing_address?.first_name +
              " " +
              cart.billing_address?.last_name,
            address: {
              city: cart.billing_address?.city ?? undefined,
              country: cart.billing_address?.country_code ?? undefined,
              line1: cart.billing_address?.address_1 ?? undefined,
              line2: cart.billing_address?.address_2 ?? undefined,
              postal_code: cart.billing_address?.postal_code ?? undefined,
              state: cart.billing_address?.province ?? undefined,
            },
            email: cart.email,
            phone: cart.billing_address?.phone ?? undefined,
          },
        },
      })
      .then(({ error, paymentIntent }) => {
        if (error) {
          const pi = error.payment_intent

          if (
            (pi && pi.status === "requires_capture") ||
            (pi && pi.status === "succeeded")
          ) {
            onPaymentCompleted()
          }

          setErrorMessage(error.message || null)
          return
        }

        if (
          (paymentIntent && paymentIntent.status === "requires_capture") ||
          paymentIntent.status === "succeeded"
        ) {
          return onPaymentCompleted()
        }

        return
      })
  }

  return (
    <>
      <Button
        disabled={disabled || notReady}
        onClick={handlePayment}
        size="large"
        isLoading={submitting}
        data-testid={dataTestId}
      >
        Place order
      </Button>
      <ErrorMessage
        error={errorMessage}
        data-testid="stripe-payment-error-message"
      />
    </>
  )
}

const MercuryPaymentButton = ({
  cart,
  notReady,
}: {
  cart: HttpTypes.StoreCart
  notReady: boolean
}) => {
  type PaymentSessionData = {
    address: string
    ada_amount: number
    customerDetails: Record<string, string>
  }

  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { wallet, state, connected } = useWallet()

  const afterConnectWallet = async () => {
    console.log(
      `Connected from payment button... Wallet: ${wallet}\nState: ${state}\nConnected: ${connected}`
    )
  }

  const unixTimeToSlots = (unixTime: number) => {
    return (
      Math.floor((unixTime - slotConfig.zeroTime) / slotConfig.slotLength) +
      slotConfig.zeroSlot
    )
  }

  const onPaymentCompleted = async () => {
    await placeOrder()
      .catch((err) => {
        setErrorMessage(err.message)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  const payment_collection = cart.payment_collection
  const payment_session = payment_collection?.payment_sessions?.[0]

  const handlePayment = async () => {
    console.log(`Attempting to handle the payment...`)
    setSubmitting(true)
    if (!connected || !payment_collection || !payment_session) {
      setSubmitting(false)
      return
    }

    const txBuilder = new MeshTxBuilder({
      verbose: true,
    })

    const payment_session_data = payment_session.data as PaymentSessionData

    const changeAddress = await wallet.getChangeAddress()
    const utxos = await wallet.getUtxos()

    // Expire the transaction 1 minute before the stale refresh
    const expiredTime = new Date(payment_session.created_at)
    expiredTime.setTime(
      expiredTime.getTime() +
        60 * (Number(process.env.STALE_THRESHOLD_MINUTES || 60) - 1) * 1000
    )

    const unsigned_tx = await txBuilder
      .txOut(payment_session_data.address as string, [
        {
          unit: "lovelace",
          quantity: (
            (payment_session_data.ada_amount as number) * 1_000_000
          ).toFixed(0),
        },
      ])
      .metadataValue(647, {
        msg: [
          payment_session_data.customerDetails.session_id?.substring(7) || "",
        ],
      })
      .changeAddress(changeAddress)
      .selectUtxosFrom(utxos)
      .invalidHereafter(unixTimeToSlots(expiredTime.getTime()))
      .complete()

    try {
      const signed_tx = await wallet.signTx(unsigned_tx)
      const tx_hash = await wallet.submitTx(signed_tx)
      console.log(`Tx Hash is: ${tx_hash}`)

      const authorize_response = await fetch(
        `http://localhost:9000/store/mercury/authorize`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "x-publishable-api-key":
              "pk_93033f741204ba718420f85320b0475aa1d8a185a97b2b2449f4719c6326593e",
          },
          body: JSON.stringify({
            id: payment_session.id,
            currency_code: payment_session.currency_code,
            amount: payment_session.amount,
            tx_hash,
          }),
        }
      )

      const { success, message } = await authorize_response.json()
      setSubmitting(false)
      if (success) {
        console.log(`Successfully authorized the payment! ${message}`)
        onPaymentCompleted();
      } else {
        console.error(message)
      }
    } catch (e) {
      console.error(
        `Could not authorize and complete transaction? ${e.message}`
      )
      setSubmitting(false)
    }
    // onPaymentCompleted()
  }

  return (
    <>
      <div className="mb-2">
        <CardanoWallet
          isDark={true}
          label={"Connect Wallet"}
          onConnected={afterConnectWallet}
        />
      </div>

      <Button
        disabled={notReady || !connected}
        isLoading={submitting}
        onClick={handlePayment}
        size="large"
        data-testid="submit-order-button"
      >
        Place Order
      </Button>
      <ErrorMessage
        error={errorMessage}
        data-testid="manual-payment-error-message"
      />
      <pre>{JSON.stringify(payment_session || "", null, 2)}</pre>
    </>
  )
}

const ManualTestPaymentButton = ({ notReady }: { notReady: boolean }) => {
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onPaymentCompleted = async () => {
    await placeOrder()
      .catch((err) => {
        setErrorMessage(err.message)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  const handlePayment = () => {
    setSubmitting(true)

    onPaymentCompleted()
  }

  return (
    <>
      <Button
        disabled={notReady}
        isLoading={submitting}
        onClick={handlePayment}
        size="large"
        data-testid="submit-order-button"
      >
        Place order
      </Button>
      <ErrorMessage
        error={errorMessage}
        data-testid="manual-payment-error-message"
      />
    </>
  )
}

export default PaymentButton
